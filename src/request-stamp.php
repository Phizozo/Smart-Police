<?php
declare(strict_types=1);

function request_signature(string $name): string {
    $parts = preg_split('/\s+/u', trim($name), -1, PREG_SPLIT_NO_EMPTY);
    if (!$parts) throw new RuntimeException('The approving account needs its full name.');
    return mb_strtoupper(mb_substr($parts[0],0,1)).' '.end($parts);
}

function request_stamped_pdf(PDO $db, array $request, array $details, array $files): string {
    $record = request_pdf_bytes($request,$details,$files,true);
    $mime='application/pdf'; $source=$record;
    if ($request['kind']==='certification') {
        $q=$db->prepare("SELECT vault,mime,sha256 FROM request_files WHERE request_id=? AND kind='copy'");
        $q->execute([$request['id']]); $copy=$q->fetch();
        if (!$copy) throw new RuntimeException('The submitted copy is missing.');
        $source=vault_get($copy['vault']); $mime=$copy['mime'];
        if (!hash_equals($copy['sha256'],hash('sha256',$source))) throw new RuntimeException('The submitted copy failed its integrity check.');
        if (in_array($mime,['image/png','image/jpeg'],true)) {
            $dimensions=getimagesizefromstring($source);
            if (!$dimensions || $dimensions[0]*$dimensions[1]>40000000) throw new InvalidArgumentException('The document image must be valid and under 40 megapixels.');
        }
    }
    $payload=json_encode([
        'kind'=>$request['kind'],'ref'=>$request['ref'],'name'=>$request['reviewer_name'],'role'=>$request['reviewer_role'],
        'signature'=>request_signature($request['reviewer_name']),
        'datetime'=>date('Y-m-d H:i:s T (P)',(int)$request['reviewed_at']),
        'at'=>date('c',(int)$request['reviewed_at']),'mime'=>$mime,
        'source'=>base64_encode($source),'sourceSha'=>hash('sha256',$source),'register'=>base64_encode($record)
    ],JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
    $process=proc_open(['node','--max-old-space-size=256',__DIR__.'/../scripts/stamp-request.mjs'],
        [['pipe','r'],['pipe','w'],['pipe','w']],$pipes,__DIR__.'/..');
    if (!is_resource($process)) throw new RuntimeException('The PDF stamping service is unavailable.');
    foreach ($pipes as $pipe) stream_set_blocking($pipe,false);
    $offset=0; $pdf=$error=''; $deadline=microtime(true)+30; $exit=-1;
    try {
        while (true) {
            if (microtime(true)>$deadline) throw new RuntimeException('PDF stamping timed out. The request was not approved.');
            if ($offset>=strlen($payload) && is_resource($pipes[0])) fclose($pipes[0]);
            $read=array_values(array_filter([$pipes[1],$pipes[2]],static fn($pipe)=>!feof($pipe)));
            $write=is_resource($pipes[0])?[$pipes[0]]:[];
            if ($read || $write) {
                $except=null;
                if (stream_select($read,$write,$except,0,100000)===false) throw new RuntimeException('PDF stamping connection failed.');
                foreach ($write as $pipe) {
                    $written=fwrite($pipe,substr($payload,$offset,65536));
                    if ($written===false || $written===0) throw new RuntimeException('The PDF stamping service is unavailable.');
                    $offset+=$written;
                }
                foreach ($read as $pipe) {
                    $chunk=fread($pipe,65536);
                    if ($chunk===false) throw new RuntimeException('Could not read the stamped PDF.');
                    if ($pipe===$pipes[1]) $pdf.=$chunk; else $error.=$chunk;
                    if (strlen($pdf)>40*1024*1024 || strlen($error)>8192) throw new RuntimeException('The PDF stamping output exceeded its safe limit.');
                }
            }
            $state=proc_get_status($process);
            if (!$state['running'] && feof($pipes[1]) && feof($pipes[2])) {$exit=$state['exitcode']; break;}
        }
    } finally {
        foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe);
        if (proc_get_status($process)['running']) proc_terminate($process,9);
        proc_close($process);
    }
    if ($exit!==0 || !str_starts_with($pdf,'%PDF-')) {
        if ($exit===2) throw new InvalidArgumentException('The copy could not be stamped. Upload a readable, flattened, unencrypted PDF (up to 200 pages) or PNG/JPEG copy under 40 megapixels.');
        throw new RuntimeException('PDF stamping failed. The request was not approved.');
    }
    return $pdf;
}
