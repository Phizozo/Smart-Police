<?php
declare(strict_types=1);
header('Content-Type: text/javascript; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=0, must-revalidate');
$path=__DIR__.'/../node_modules/echarts/dist/echarts.min.js';
if (!is_file($path)) {
    http_response_code(503);
    echo 'throw new Error("The local chart runtime is unavailable. Install locked npm dependencies.");';
    exit;
}
readfile($path);
