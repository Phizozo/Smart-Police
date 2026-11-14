<?php
declare(strict_types=1);

// Serve only the local PDF.js browser runtime, never application data or arbitrary paths.
$path = $_SERVER['PATH_INFO'] ?? '';
$root = realpath(__DIR__.'/../node_modules/pdfjs-dist');
header('X-Content-Type-Options: nosniff');
header('Cross-Origin-Resource-Policy: same-origin');
if ($root === false) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=UTF-8');
    exit('The local PDF renderer is not installed. Run npm ci or start the app using start.sh/start.bat.');
}
$allowed = $path === '/LICENSE' || in_array($path, ['/build/pdf.mjs','/build/pdf.worker.mjs','/build/pdf.renderer.mjs'], true)
    || preg_match('~^/(cmaps|standard_fonts|wasm)/[A-Za-z0-9_.-]+\.(bcmap|pfb|ttf|wasm|js)$~D', $path);
$file = $allowed ? realpath($root.$path) : false;
if (!$file || !str_starts_with($file, $root.DIRECTORY_SEPARATOR) || !is_file($file)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    exit('PDF renderer asset not found.');
}
$extension = pathinfo($file, PATHINFO_EXTENSION);
$mime = match($extension) {
    'mjs','js' => 'text/javascript; charset=UTF-8',
    'wasm' => 'application/wasm',
    'ttf' => 'font/ttf',
    default => $path === '/LICENSE' ? 'text/plain; charset=UTF-8' : 'application/octet-stream',
};
header('Content-Type: '.$mime);
// Revalidate runtime code when the pinned PDF.js package changes.
header('Cache-Control: no-cache');
header('Content-Length: '.filesize($file));
readfile($file);
