<?php
declare(strict_types=1);

// Presentation-only phone OTP: never grants a session or satisfies real two-step auth.
function phone_otp_demo(PDO $db, string $action, array $body): never {
    csrf_need();
    $user = need(['citizen']);
    $q = $db->prepare('SELECT phone FROM users WHERE id=?');
    $q->execute([$user['id']]);
    $phone = (string)$q->fetchColumn();
    if (!preg_match('/^\+27[1-9][0-9]{8}$/D', $phone)) out(['error'=>'Your account needs a valid registered +27 phone number.'],400);
    if ($action === 'phone_otp_send') {
        $previous = $_SESSION['phone_otp_demo'] ?? [];
        if (time() - (int)($previous['sent'] ?? 0) < 60) out(['error'=>'Wait 60 seconds before requesting another code.'],429);
        $code = (string)random_int(100000,999999);
        $_SESSION['phone_otp_demo'] = ['user'=>(int)$user['id'], 'phone'=>$phone,
            'hash'=>hash('sha256',$code), 'sent'=>time(), 'expires'=>time()+300, 'attempts'=>0];
        audit('phone.otp_demo_sent','Simulation only; no SMS sent',$user);
        out(['ok'=>1,'message'=>'Code sent','demo'=>true,'demo_code'=>$code,
            'phone'=>'••••••'.substr($phone,-4),'expires_in'=>300]);
    }
    $challenge = $_SESSION['phone_otp_demo'] ?? null;
    if (!$challenge || $challenge['user'] !== (int)$user['id'] || $challenge['phone'] !== $phone ||
        time() >= $challenge['expires'] || $challenge['attempts'] >= 5 || empty($challenge['hash'])) {
        out(['error'=>'No active code. Request a new code; codes expire after 5 minutes and 5 attempts.'],400);
    }
    $_SESSION['phone_otp_demo']['attempts']++;
    $code = $body['code'] ?? '';
    if (!is_string($code) || !preg_match('/^[0-9]{6}$/D',$code) ||
        !hash_equals($challenge['hash'],hash('sha256',$code))) out(['error'=>'Incorrect code.'],400);
    unset($_SESSION['phone_otp_demo']['hash']);
    audit('phone.otp_demo_verified','Simulation completed; phone ownership not verified',$user);
    out(['ok'=>1,'message'=>'Demo code confirmed. No SMS was sent; phone ownership is not verified.']);
}
