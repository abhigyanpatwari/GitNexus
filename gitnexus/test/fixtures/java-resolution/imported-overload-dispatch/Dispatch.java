interface Parent { void task(); } interface Child extends Parent {}
        interface StaticAPI {
          static void staticRun() {} private void privateRun() {}
          default void privateBridge() { this.privateRun(); }
        }
        class RuntimeDecoy implements StaticAPI { public void staticRun() {} public void privateRun() {} }
        class ChildImpl implements Child { public void task() {} }
        class OtherImpl implements Parent { public void task() {} }
        class Dispatch {
          void staticDispatch() { StaticAPI.staticRun(); }
          void childDispatch(Child child) { child.task(); }
          void anonymousDispatch() { Child child = new Child() { public void task() {} }; child.task(); }
          void runnableGood() { Runnable r = new Runnable() { public void run() {} public void run(String x) {} }; r.run(); }
          void runnableBad() { Runnable r = new Runnable() { public void run() {} public void run(String x) {} }; r.run("x"); }
          static Child create(int n) { return new ChildImpl(); }
          void returnedChild() { create(1).task(); }
        }
