<?php
interface Renderer {
    public function render(): string;
}
class Base implements Renderer {
    public string $render = "render";
    public function render(): string { return $this->render; }
}
class Child extends Base {
    public function render(): string { return parent::RENDER(); }
}
class Other {
    public function render(): string { return "other"; }
}
function invoke(Renderer $value, Other $other) {
    return $value->RENDER() . $other->render();
}
// render stays here.
