def boot
  def target
    :nested
  end
end

def caller
  boot
  target
end

class Host
  Other.class_eval do
    def rebound
      :rebound
    end
  end

  def class_eval_caller
    rebound
  end
end
