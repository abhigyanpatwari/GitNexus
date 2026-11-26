package client;

import java.util.*;

abstract class Handler implements Thread.UncaughtExceptionHandler {}
class Base {}
class Accepted extends Project.api.Base {
    void check() { this.ping(); }
}

class IOException {}
class ReadFailure extends java.io.IOException {}
