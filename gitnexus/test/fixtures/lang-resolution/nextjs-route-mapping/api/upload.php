<?php
header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
echo json_encode(['status' => 'ok', 'id' => 1]);
