<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../includes/auth.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!is_logged_in()) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized', 'code' => 'AUTH_REQUIRED'], JSON_UNESCAPED_UNICODE);
    exit;
}

$items = get_items();
echo json_encode(['data' => $items, 'total' => count($items)], JSON_UNESCAPED_UNICODE);
