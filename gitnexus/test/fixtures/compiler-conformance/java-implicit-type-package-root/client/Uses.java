package client;

abstract class Handler implements Thread.UncaughtExceptionHandler {}
class Accepted extends Project.api.Base {
    void check() { this.ping(); }
}
