<?php
interface Renderer {
    public function paint(): string;
}
class Base implements Renderer {
    public string $render = "render";
    public function paint(): string { return $this->render; }
}
class Child extends Base {
    public function paint(): string { return parent::paint(); }
}
class Other {
    public function render(): string { return "other"; }
}
function invoke(Renderer $value, Other $other) {
    return $value->paint() . $other->render();
}
// render stays here.
