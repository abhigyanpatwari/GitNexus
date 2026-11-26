package c
        import a.Parent
        import a.Base
        import a.Concrete
        class KotlinCaller {
          constructor(marker: String) { beanFactory.getBean(Concrete::class.java) }
          fun kotlinCollection(){ SpringContextUtil.getBeans(Parent::class.java) }
          fun adjacentMiss(){}
          fun kotlinBase(){ applicationContext.getBeansOfType(Base::class.java) }
          fun kotlinSingle(){ ctx.getBean(Concrete::class) }
          fun kotlinOuter() {
            val task = object : Runnable {
              override fun run() { ctx.getBeans(Parent::class.java) }
            }
          }
          fun kotlinFalsePositives() {
            // ctx.getBeans(Parent::class.java)
            /* applicationContext.getBeansOfType(Parent::class.java) */
            val normal = "ctx.getBean(Concrete::class.java)"
            val raw = """ctx.getBeans(Parent::class.java)"""
          }
        }