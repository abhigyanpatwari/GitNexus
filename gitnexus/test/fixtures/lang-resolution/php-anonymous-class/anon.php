<?php
$service = new class {
    public function execute(): void {
        echo "running";
    }
};
$service->execute();
