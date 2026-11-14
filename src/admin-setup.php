<?php
declare(strict_types=1);

// Bearer links live in URL fragments. Only epoch-bound hashes are retained.
function admin_setup_hash(string $token): string {
    return hash('sha256', 'admin-setup|' . $_SESSION['epoch'] . '|' . $token);
}

function admin_setup_issue(PDO $db, array $body, bool $reissue, ?string $addRole = null): never {
    $admin=need(['admin']);
    $token=bin2hex(random_bytes(32)); $hash=admin_setup_hash($token); $expires=time()+3600;
    $role=$addRole ?? 'admin';
    if (!in_array($role,['admin','officer'],true)) out(['error'=>'Choose an Admin or Officer account.'],400);
    $db->beginTransaction();
    try {
        if ($reissue) {
            $id=(int)($body['id']??0);
            $q=$db->prepare("SELECT id,username,role FROM users WHERE id=? AND role IN('admin','officer') AND approval_status='active' AND suspended=0 AND admin_setup_hash IS NOT NULL");
            $q->execute([$id]); $target=$q->fetch();
            if (!$target) { $db->rollBack(); out(['error'=>'This staff account does not have a pending password setup. Use password reset for an activated account.'],409); }
            $username=$target['username']; $role=$target['role'];
            $db->prepare('UPDATE users SET admin_setup_hash=?,admin_setup_expires=? WHERE id=?')->execute([$hash,$expires,$id]);
        } else {
            $name=str($body,'name',80);
            if (mb_strlen($name)<2 || preg_match('/\p{Cc}/u',$name)) { $db->rollBack(); out(['error'=>'Enter a full name of 2–80 characters.'],400); }
            if ($role==='admin') {
                $email=admin_email_value($body);
            } else {
                $email=strtolower(str($body,'email',254));
                if (!filter_var($email,FILTER_VALIDATE_EMAIL)) { $db->rollBack(); out(['error'=>'Enter a valid Officer email address.'],400); }
                $emailCheck=$db->prepare('SELECT 1 FROM users WHERE lower(email)=?'); $emailCheck->execute([$email]);
                if ($emailCheck->fetchColumn()) { $db->rollBack(); out(['error'=>'That email address is already in use.'],409); }
            }
            $username=username_value($body);
            $q=$db->prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)');
            $q->execute([$username]);
            if ($q->fetchColumn()) { $db->rollBack(); out(['error'=>'That username is already in use. Choose another username.'],409); }
            // An unknown, out-of-policy random password prevents login before setup.
            $placeholder=password_hash(bin2hex(random_bytes(32)),PASSWORD_DEFAULT);
            $db->prepare('INSERT INTO users(username,name,role,pass_hash,created,email,admin_setup_hash,admin_setup_expires) VALUES(?,?,?,?,?,?,?,?)')
               ->execute([$username,$name,$role,$placeholder,time(),$email,$hash,$expires]);
            $id=(int)$db->lastInsertId();
        }
        audit($reissue?$role.'.setup_reissued':$role.'.added','Account #'.$id,$admin);
        $db->commit();
    } catch(Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        if ($error instanceof PDOException && $error->getCode()==='23000') out(['error'=>'That email or account name is already in use.'],409);
        throw $error;
    }
    out(['ok'=>1,'id'=>$id,'username'=>$username,'role'=>$role,'setup_fragment'=>'#admin-setup/'.$token,'expires_at'=>$expires]);
}

function admin_setup_target(PDO $db,array $body): array {
    csrf_need();
    $q=$db->prepare("SELECT COUNT(*) FROM audit WHERE action='admin.setup_failed' AND ip=? AND ts>?");
    $q->execute([$_SERVER['REMOTE_ADDR']??'',time()-600]);
    if ((int)$q->fetchColumn()>=30) out(['error'=>'Too many invalid setup attempts. Try again in 10 minutes.'],429);
    $token=$body['token']??'';
    $target=false;
    if (is_string($token) && preg_match('/^[a-f0-9]{64}$/D',$token)) {
        $q=$db->prepare("SELECT id,username,name,email,role,admin_setup_hash,admin_setup_expires FROM users WHERE admin_setup_hash=? AND admin_setup_expires>? AND role IN('admin','officer') AND approval_status='active' AND suspended=0");
        $q->execute([admin_setup_hash($token),time()]); $target=$q->fetch();
    }
    if (!$target) {
        audit('admin.setup_failed','Invalid or unavailable password setup link');
        out(['error'=>'This password setup link is invalid, expired, replaced, or already used. Ask an Admin for a new link.'],410);
    }
    return $target;
}

function admin_setup_complete(PDO $db,array $body): never {
    $target=admin_setup_target($db,$body);
    $password=password_value($body); password_creation_need($password);
    if (!isset($body['confirm']) || !is_string($body['confirm']) || !hash_equals($password,$body['confirm'])) out(['error'=>'Passwords do not match.'],400);
    $db->beginTransaction();
    try {
        $q=$db->prepare("UPDATE users SET pass_hash=?,admin_setup_hash=NULL,admin_setup_expires=NULL WHERE id=? AND admin_setup_hash=? AND admin_setup_expires>? AND role IN('admin','officer') AND approval_status='active' AND suspended=0");
        $q->execute([password_hash($password,PASSWORD_DEFAULT),$target['id'],$target['admin_setup_hash'],time()]);
        if (!$q->rowCount()) { $db->rollBack(); out(['error'=>'This setup link is no longer available. Ask an Admin for a new link.'],410); }
        audit($target['role'].'.password_setup','Account #'.$target['id'],['id'=>$target['id'],'username'=>$target['username']]);
        $db->commit();
    } catch(Throwable $error) { if ($db->inTransaction()) $db->rollBack(); throw $error; }
    // No session is created or switched by setting a password.
    out(['ok'=>1,'username'=>$target['username'],'role'=>$target['role']]);
}
