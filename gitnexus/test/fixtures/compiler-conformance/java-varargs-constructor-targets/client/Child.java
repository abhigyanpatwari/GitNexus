package client;

import api.Base;

class Child extends Base {
    Child() { super("value"); }
    Base ordinary() { return new Base("value"); }
}
