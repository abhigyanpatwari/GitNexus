<?php
namespace App;

class Child extends Base {
    use Auditable;

    public function callViaParent(): string {
        return parent::record();
    }

    public function callViaThis(): string {
        return $this->record();
    }
}
