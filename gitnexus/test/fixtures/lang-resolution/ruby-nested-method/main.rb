def boot
  def target
    :nested
  end
end

def caller
  boot
  target
end

def boot_commented
  def # an ordinary method despite the comment before its name
    commented_target
    :nested
  end
end

def commented_caller
  boot_commented
  commented_target
end

class Host
  def boot_class
    def class_target
      :nested_class_method
    end
  end

  def class_caller
    boot_class
    class_target
  end

  Other.class_eval do
    def rebound
      :rebound
    end
  end

  def class_eval_caller
    rebound
  end

  def self.install(&body)
    Other.class_eval(&body)
  end

  install do
    def helper_target
      :belongs_to_other
    end
  end

  def helper_caller
    helper_target
  end
end
