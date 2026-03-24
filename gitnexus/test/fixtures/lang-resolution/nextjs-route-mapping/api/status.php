<?php
header('Content-Type: application/json');
echo json_encode(['status' => 'running', 'uptime' => 3600]);
