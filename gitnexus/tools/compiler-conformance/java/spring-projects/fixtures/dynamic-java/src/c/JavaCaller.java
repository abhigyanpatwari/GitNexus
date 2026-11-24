package c;
        import a.Parent;
        import a.Base;
        import a.Concrete;
        import a.RecordBean;
        class JavaCaller {
          JavaCaller() { beanFactory.getBean(Concrete.class); }
          void javaCollection(){ SpringContextUtil.getBeans(Parent.class); }
          void adjacentMiss(){}
          void javaBase(){ applicationContext.getBeansOfType(Base.class); }
          void javaSingle(){ ctx.getBean(Concrete.class); }
          void javaRecord(){ ctx.getBean(RecordBean.class); }
          void javaAmbiguousSingle(){ ctx.getBean(Parent.class); }
          void javaOuter() {
            Runnable task = new Runnable() {
              public void run() { ctx.getBeans(Parent.class); }
            };
          }
          void javaFalsePositives() {
            // ctx.getBeans(Parent.class);
            /* applicationContext.getBeansOfType(Parent.class); */
            String normal = "ctx.getBean(Concrete.class)";
            String block = """
              ctx.getBeans(Parent.class)
              """;
          }
        }