<?php
declare(strict_types=1);

use Cose\Algorithm\Manager;
use Cose\Algorithm\Signature\ECDSA\ES256;
use Cose\Algorithm\Signature\RSA\RS256;
use Symfony\Component\Serializer\Normalizer\AbstractObjectNormalizer;
use Webauthn\AttestationStatement\AttestationStatementSupportManager;
use Webauthn\AttestationStatement\NoneAttestationStatementSupport;
use Webauthn\AuthenticatorAssertionResponse;
use Webauthn\AuthenticatorAssertionResponseValidator;
use Webauthn\AuthenticatorAttestationResponse;
use Webauthn\AuthenticatorAttestationResponseValidator;
use Webauthn\AuthenticatorSelectionCriteria;
use Webauthn\CeremonyStep\CeremonyStepManagerFactory;
use Webauthn\CredentialRecord;
use Webauthn\Denormalizer\WebauthnSerializerFactory;
use Webauthn\PublicKeyCredential;
use Webauthn\PublicKeyCredentialCreationOptions;
use Webauthn\PublicKeyCredentialDescriptor;
use Webauthn\PublicKeyCredentialParameters;
use Webauthn\PublicKeyCredentialRequestOptions;
use Webauthn\PublicKeyCredentialRpEntity;
use Webauthn\PublicKeyCredentialUserEntity;

function passkey_services(): array {
  static $services = null;
  if ($services !== null) return $services;
  $autoload = __DIR__ . '/../vendor/autoload.php';
  if (!is_file($autoload)) out(['error' => 'Passkey sign-in is not configured. Use your password instead.'], 503);
  require_once $autoload;

  $hostHeader = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
  if (!preg_match('/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/iD', $hostHeader)) {
    out(['error' => 'Passkey sign-in is unavailable for this website address.'], 400);
  }
  $parts = parse_url('https://' . $hostHeader);
  $rpId = strtolower((string)($parts['host'] ?? ''));
  if ($rpId === '') out(['error' => 'Passkey sign-in is unavailable for this website address.'], 400);
  $forwarded = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
  $scheme = $forwarded !== '' ? $forwarded : ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http');
  if (!in_array($scheme, ['http', 'https'], true)) out(['error' => 'Passkey sign-in is unavailable for this connection.'], 400);
  $port = (int)($parts['port'] ?? 0);
  $originHost = str_starts_with($rpId, ':') ? '[' . $rpId . ']' : $rpId;
  $origin = $scheme . '://' . $originHost . ($port && !(($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80)) ? ':' . $port : '');
  $requestOrigin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
  if ($requestOrigin !== '' && !hash_equals($origin, rtrim($requestOrigin, '/'))) {
    out(['error' => 'Passkey request origin did not match this website.'], 403);
  }

  $attestationManager = new AttestationStatementSupportManager();
  $attestationManager->add(new NoneAttestationStatementSupport());
  $algorithms = Manager::create()->add(ES256::create(), RS256::create());
  $serializer = (new WebauthnSerializerFactory($attestationManager))->create();
  $ceremonyFactory = new CeremonyStepManagerFactory();
  $ceremonyFactory->setAttestationStatementSupportManager($attestationManager);
  $ceremonyFactory->setAlgorithmManager($algorithms);
  $ceremonyFactory->setAllowedOrigins([$origin]);
  $services = [
    'rpId' => $rpId,
    'origin' => $origin,
    'serializer' => $serializer,
    'attestation' => AuthenticatorAttestationResponseValidator::create($ceremonyFactory->creationCeremony()),
    'assertion' => AuthenticatorAssertionResponseValidator::create($ceremonyFactory->requestCeremony()),
  ];
  return $services;
}

function passkey_b64url_encode(string $bytes): string {
  return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

// Bind challenges to the password, registered credential and security policy.
function passkey_account_version(array $account): string {
  return hash('sha256', $account['pass_hash'] . '|' . $account['passkey_credential'] . '|' . (int)$account['two_step_enabled'] . '|' . (int)($account['suspended_at'] ?? 0));
}

function passkey_rate_limit(PDO $db, string $username): void {
  $attempts = $db->prepare("SELECT COUNT(*) FROM audit WHERE action='login.fail' AND username=? AND ts>?");
  $attempts->execute([$username, time() - 600]);
  if ((int)$attempts->fetchColumn() >= 5) out(['error' => 'Too many failed attempts. Try again in 10 minutes.'], 429);
}

function passkey_request_options(array $services, array $account, string $challenge): PublicKeyCredentialRequestOptions {
  $record = passkey_credential_record($services, $account['passkey_credential']);
  return PublicKeyCredentialRequestOptions::create(
    $challenge, $services['rpId'],
    [PublicKeyCredentialDescriptor::create('public-key', $record->publicKeyCredentialId, $record->transports)],
    PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED, 60_000,
  );
}

function passkey_check_assertion(array $services, array $account, string $challenge): CredentialRecord {
  $credential = $services['serializer']->deserialize(file_get_contents('php://input') ?: '{}', PublicKeyCredential::class, 'json');
  if (!$credential instanceof PublicKeyCredential || !$credential->response instanceof AuthenticatorAssertionResponse) {
    throw new RuntimeException('Expected an authenticator assertion response.');
  }
  $record = passkey_credential_record($services, $account['passkey_credential']);
  if (!hash_equals($record->publicKeyCredentialId, $credential->rawId)) throw new RuntimeException('Unknown passkey.');
  return $services['assertion']->check(
    $record, $credential->response,
    passkey_request_options($services, $account, passkey_b64url_decode($challenge)),
    $services['rpId'], passkey_b64url_decode($account['passkey_user_handle']),
  );
}

function passkey_two_step_options(PDO $db, array $body): never {
  $user = need(['citizen']);
  unset($_SESSION['passkey_two_step'], $_SESSION['passkey_registration']);
  if (!isset($body['enabled']) || !is_bool($body['enabled'])) out(['error' => 'Choose whether to enable two-step verification.'], 400);
  $query = $db->prepare("SELECT * FROM users WHERE id=? AND role='citizen' AND approval_status='active' AND suspended=0");
  $query->execute([$user['id']]);
  $account = $query->fetch();
  passkey_rate_limit($db, (string)$user['username']);
  if (!$account || !password_verify(password_value($body), $account['pass_hash'])) {
    audit('login.fail', 'two-step setting password rejected', $user);
    out(['error' => 'Your current password is incorrect.'], 403);
  }
  if (!$account['passkey_credential'] || !$account['passkey_user_handle']) out(['error' => 'Set up a device passkey first.'], 409);
  $services = passkey_services();
  $challenge = random_bytes(32);
  $_SESSION['passkey_two_step'] = [
    'user_id' => (int)$user['id'], 'issued' => time(),
    'version' => passkey_account_version($account), 'enabled' => $body['enabled'],
    'challenge' => passkey_b64url_encode($challenge),
  ];
  out(['options' => passkey_json_options($services, passkey_request_options($services, $account, $challenge))]);
}

function passkey_two_step_verify(PDO $db): never {
  $user = need(['citizen']);
  $pending = $_SESSION['passkey_two_step'] ?? null;
  unset($_SESSION['passkey_two_step']);
  $query = $db->prepare('SELECT * FROM users WHERE id=?');
  $query->execute([$user['id']]);
  $account = $query->fetch();
  if (!is_array($pending) || (int)$pending['user_id'] !== (int)$user['id'] ||
      time() - (int)$pending['issued'] > 180 || !$account ||
      !hash_equals((string)$pending['version'], passkey_account_version($account))) {
    out(['error' => 'Security verification expired. Enter your password and try again.'], 400);
  }
  passkey_rate_limit($db, (string)$account['username']);
  try {
    $services = passkey_services();
    $updated = passkey_check_assertion($services, $account, (string)$pending['challenge']);
    $save = $db->prepare('UPDATE users SET two_step_enabled=?,passkey_credential=?,passkey_last_used=? WHERE id=? AND pass_hash=? AND passkey_credential=? AND two_step_enabled=?');
    $save->execute([(int)$pending['enabled'], $services['serializer']->serialize($updated, 'json'), time(), $user['id'], $account['pass_hash'], $account['passkey_credential'], $account['two_step_enabled']]);
    if ($save->rowCount() !== 1) throw new RuntimeException('Security settings changed. Try again.');
    signed_in((int)$user['id'], $account['pass_hash'], (bool)$pending['enabled']);
    audit($pending['enabled'] ? 'security.two_step.enabled' : 'security.two_step.disabled', 'Password and device passkey verified', $user);
    out(['ok' => 1, 'message' => $pending['enabled'] ? 'Two-step verification enabled.' : 'Two-step verification disabled.', 'csrf' => $_SESSION['csrf']]);
  } catch (Throwable $error) {
    error_log('Two-step settings verification rejected: ' . $error->getMessage());
    audit('login.fail', 'two-step setting passkey rejected', $user);
    out(['error' => 'Passkey was not verified. Enter your password and try again.'], 403);
  }
}

function passkey_b64url_decode(string $encoded): string {
  if ($encoded === '' || !preg_match('/^[A-Za-z0-9_-]+$/D', $encoded)) throw new RuntimeException('Invalid passkey data.');
  $decoded = base64_decode(strtr($encoded, '-_', '+/') . str_repeat('=', (4 - strlen($encoded) % 4) % 4), true);
  if ($decoded === false) throw new RuntimeException('Invalid passkey data.');
  return $decoded;
}

function passkey_json_options(array $services, object $options): array {
  $json = $services['serializer']->serialize($options, 'json', [
    'json_encode_options' => JSON_THROW_ON_ERROR,
    AbstractObjectNormalizer::SKIP_NULL_VALUES => true,
  ]);
  $decoded = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
  if (!is_array($decoded)) throw new RuntimeException('Could not create passkey options.');
  return $decoded;
}

function passkey_credential_record(array $services, string $json): CredentialRecord {
  $record = $services['serializer']->deserialize($json, CredentialRecord::class, 'json');
  if (!$record instanceof CredentialRecord) throw new RuntimeException('Invalid saved passkey.');
  return $record;
}

function passkey_creation_options(array $services, array $user, string $challenge, string $userHandle, array $exclude = []): PublicKeyCredentialCreationOptions {
  return PublicKeyCredentialCreationOptions::create(
    PublicKeyCredentialRpEntity::create('Smart Police', $services['rpId']),
    PublicKeyCredentialUserEntity::create((string)$user['username'], $userHandle, (string)$user['name']),
    $challenge,
    [
      PublicKeyCredentialParameters::create('public-key', -7),
      PublicKeyCredentialParameters::create('public-key', -257),
    ],
    AuthenticatorSelectionCriteria::create(
      AuthenticatorSelectionCriteria::AUTHENTICATOR_ATTACHMENT_PLATFORM,
      AuthenticatorSelectionCriteria::USER_VERIFICATION_REQUIREMENT_REQUIRED,
      AuthenticatorSelectionCriteria::RESIDENT_KEY_REQUIREMENT_REQUIRED,
    ),
    PublicKeyCredentialCreationOptions::ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
    $exclude,
    60_000,
  );
}

function passkey_register_options(PDO $db, array $body): never {
  $user = need(['citizen']);
  if ($user['two_step_enabled']) out(['error' => 'Disable two-step verification with your current passkey before replacing it.'], 409);
  passkey_rate_limit($db, (string)$user['username']);
  $password = password_value($body);
  $query = $db->prepare('SELECT id,username,name,pass_hash,passkey_user_handle,passkey_credential,passkey_label FROM users WHERE id=? AND role=\'citizen\' AND approval_status=\'active\'');
  $query->execute([$user['id']]);
  $account = $query->fetch();
  if (!$account || strlen($password) > 1024 || !password_verify($password, $account['pass_hash'])) {
    audit('login.fail', 'passkey enrollment password rejected', $user);
    audit('passkey.enrollment.denied', 'Password confirmation failed', $user);
    out(['error' => 'Your current password is incorrect.'], 403);
  }

  $handle = $account['passkey_user_handle'] ? passkey_b64url_decode($account['passkey_user_handle']) : random_bytes(32);
  if (!$account['passkey_user_handle']) {
    $db->prepare('UPDATE users SET passkey_user_handle=? WHERE id=?')->execute([passkey_b64url_encode($handle), $user['id']]);
  }
  $exclude = [];
  if ($account['passkey_credential']) {
    $saved = passkey_credential_record(passkey_services(), $account['passkey_credential']);
    $exclude[] = PublicKeyCredentialDescriptor::create('public-key', $saved->publicKeyCredentialId, $saved->transports);
  }
  $services = passkey_services();
  $challenge = random_bytes(32);
  $_SESSION['passkey_registration'] = [
    'user_id' => (int)$user['id'],
    'challenge' => passkey_b64url_encode($challenge),
    'issued' => time(),
    'label' => mb_substr(trim((string)($body['label'] ?? 'My device')), 0, 80) ?: 'My device',
  ];
  out(['options' => passkey_json_options($services, passkey_creation_options($services, $account, $challenge, $handle, $exclude))]);
}

function passkey_register_verify(PDO $db): never {
  $user = need(['citizen']);
  if ($user['two_step_enabled']) out(['error' => 'Disable two-step verification before replacing your passkey.'], 409);
  $pending = $_SESSION['passkey_registration'] ?? null;
  unset($_SESSION['passkey_registration']);
  if (!is_array($pending) || (int)($pending['user_id'] ?? 0) !== (int)$user['id'] ||
      time() - (int)($pending['issued'] ?? 0) > 180) {
    out(['error' => 'Passkey setup expired. Start again from Account security.'], 400);
  }
  $query = $db->prepare('SELECT id,username,name,passkey_user_handle,passkey_credential FROM users WHERE id=? AND role=\'citizen\' AND approval_status=\'active\'');
  $query->execute([$user['id']]);
  $account = $query->fetch();
  if (!$account || !$account['passkey_user_handle']) out(['error' => 'Passkey setup is unavailable. Start again.'], 400);

  try {
    $services = passkey_services();
    $credential = $services['serializer']->deserialize(file_get_contents('php://input') ?: '{}', PublicKeyCredential::class, 'json');
    if (!$credential instanceof PublicKeyCredential || !$credential->response instanceof AuthenticatorAttestationResponse) {
      throw new RuntimeException('Expected an authenticator registration response.');
    }
    $handle = passkey_b64url_decode($account['passkey_user_handle']);
    $challenge = passkey_b64url_decode((string)$pending['challenge']);
    $options = passkey_creation_options($services, $account, $challenge, $handle);
    $record = $services['attestation']->check($credential->response, $options, $services['rpId']);
    $label = trim((string)($pending['label'] ?? 'My device'));
    $db->prepare('UPDATE users SET passkey_credential=?,passkey_label=?,passkey_created=?,passkey_last_used=NULL WHERE id=?')
      ->execute([$services['serializer']->serialize($record, 'json'), $label, time(), $user['id']]);
    audit(empty($account['passkey_credential']) ? 'passkey.enrolled' : 'passkey.replaced', $label, $user);
    out(['ok' => 1, 'message' => 'Device passkey saved. Face ID or another device credential can be used when available.']);
  } catch (Throwable $error) {
    error_log('Passkey registration rejected: ' . $error->getMessage());
    out(['error' => 'The device could not verify this passkey. Start setup again or use your password.'], 400);
  }
}

function passkey_login_options(PDO $db, array $body): never {
  csrf_need();
  $username = username_value($body);
  $attempts = $db->prepare("SELECT COUNT(*) FROM audit WHERE action='login.fail' AND username=? AND ts>?");
  $attempts->execute([$username, time() - 600]);
  if ((int)$attempts->fetchColumn() >= 5) out(['error' => 'Too many failed attempts. Try again in 10 minutes.'], 429);
  $query = $db->prepare("SELECT * FROM users WHERE username=?");
  $query->execute([$username]);
  $account = $query->fetch();
  if (!$account || $account['role'] !== 'citizen' || $account['approval_status'] !== 'active' || (int)$account['suspended'] === 1 || !$account['passkey_credential'] || !$account['passkey_user_handle']) {
    audit('login.fail', 'passkey unavailable', ['username' => $username]);
    out(['error' => 'No active passkey is available for this Citizen account. Use password sign-in.'], 400);
  }
  $services = passkey_services();
  $twoStep = (int)$account['two_step_enabled'] === 1;
  $passwordStep = $_SESSION['two_step_pending'] ?? null;
  if ($twoStep && (!is_array($passwordStep) || (int)$passwordStep['user_id'] !== (int)$account['id'] ||
      time() - (int)$passwordStep['issued'] > 180 ||
      !hash_equals((string)$passwordStep['version'], passkey_account_version($account)))) {
    unset($_SESSION['two_step_pending'], $_SESSION['passkey_login']);
    out(['error' => 'Enter your password first, then verify your device passkey to complete two-step sign-in.'], 403);
  }
  $record = passkey_credential_record($services, $account['passkey_credential']);
  $challenge = random_bytes(32);
  $_SESSION['passkey_login'] = [
    'user_id' => (int)$account['id'], 'challenge' => passkey_b64url_encode($challenge), 'issued' => time(),
    'version' => passkey_account_version($account), 'password_verified' => $twoStep,
  ];
  $options = PublicKeyCredentialRequestOptions::create(
    $challenge,
    $services['rpId'],
    [PublicKeyCredentialDescriptor::create('public-key', $record->publicKeyCredentialId, $record->transports)],
    PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED,
    60_000,
  );
  out(['options' => passkey_json_options($services, $options)]);
}

function passkey_login_verify(PDO $db): never {
  csrf_need();
  $pending = $_SESSION['passkey_login'] ?? null;
  $passwordStep = $_SESSION['two_step_pending'] ?? null;
  unset($_SESSION['passkey_login'], $_SESSION['two_step_pending']);
  if (!is_array($pending) || time() - (int)($pending['issued'] ?? 0) > 180) {
    out(['error' => 'Passkey sign-in expired. Start again or use your password.'], 400);
  }
  $query = $db->prepare("SELECT * FROM users WHERE id=? AND role='citizen' AND approval_status='active' AND suspended=0");
  $query->execute([(int)$pending['user_id']]);
  $account = $query->fetch();
  if (!$account || !$account['passkey_credential'] || !$account['passkey_user_handle']) {
    out(['error' => 'Passkey sign-in is unavailable. Use your password.'], 401);
  }
  if (!hash_equals((string)($pending['version'] ?? ''), passkey_account_version($account)) ||
      ((int)$account['two_step_enabled'] === 1 && (empty($pending['password_verified']) || !is_array($passwordStep) ||
       (int)$passwordStep['user_id'] !== (int)$account['id'] || time() - (int)$passwordStep['issued'] > 180 ||
       !hash_equals((string)$passwordStep['version'], passkey_account_version($account))))) {
    out(['error' => 'Two-step sign-in expired. Enter your password again.'], 401);
  }
  passkey_rate_limit($db, (string)$account['username']);

  try {
    $services = passkey_services();
    $credential = $services['serializer']->deserialize(file_get_contents('php://input') ?: '{}', PublicKeyCredential::class, 'json');
    if (!$credential instanceof PublicKeyCredential || !$credential->response instanceof AuthenticatorAssertionResponse) {
      throw new RuntimeException('Expected an authenticator assertion response.');
    }
    $record = passkey_credential_record($services, $account['passkey_credential']);
    if (!hash_equals($record->publicKeyCredentialId, $credential->rawId)) throw new RuntimeException('Unknown passkey.');
    $handle = passkey_b64url_decode($account['passkey_user_handle']);
    $challenge = passkey_b64url_decode((string)$pending['challenge']);
    $options = PublicKeyCredentialRequestOptions::create(
      $challenge,
      $services['rpId'],
      [PublicKeyCredentialDescriptor::create('public-key', $record->publicKeyCredentialId, $record->transports)],
      PublicKeyCredentialRequestOptions::USER_VERIFICATION_REQUIREMENT_REQUIRED,
      60_000,
    );
    $updated = $services['assertion']->check($record, $credential->response, $options, $services['rpId'], $handle);
    $save = $db->prepare('UPDATE users SET passkey_credential=?,passkey_last_used=? WHERE id=? AND pass_hash=? AND passkey_credential=? AND two_step_enabled=?');
    $save->execute([$services['serializer']->serialize($updated, 'json'), time(), $account['id'], $account['pass_hash'], $account['passkey_credential'], $account['two_step_enabled']]);
    if ($save->rowCount() !== 1) throw new RuntimeException('Account security changed. Restart sign-in.');
    signed_in((int)$account['id'], (string)$account['pass_hash'], !empty($pending['password_verified']));
    audit('login.passkey', !empty($pending['password_verified']) ? 'citizen | two-step verified' : 'citizen', $account);
    out(['ok' => 1, 'csrf' => $_SESSION['csrf']]);
  } catch (Throwable $error) {
    error_log('Passkey sign-in rejected: ' . $error->getMessage());
    audit('login.fail', 'passkey assertion rejected', $account);
    out(['error' => 'Passkey was not verified. Try again or use your password.'], 401);
  }
}
