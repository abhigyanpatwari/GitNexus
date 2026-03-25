<?php
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Status: 405 Method Not Allowed');
    echo json_encode(['error' => 'POST only']);
    die();
}

$data = json_decode(file_get_contents('php://input'), true);

if (empty($data['name'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Validation failed', 'field' => 'name']);
    exit(1);
}

try {
    $id = save_item($data);
    echo json_encode(['ok' => true, 'id' => $id, 'created_at' => date('c')]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database error']);
}
