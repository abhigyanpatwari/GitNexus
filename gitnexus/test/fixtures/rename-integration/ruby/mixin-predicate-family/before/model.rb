module Contract
  def ready?
    true
  end
end
class Worker
  include Contract
  def ready?
    true
  end
end
class Other
  def ready?
    false
  end
end
worker = Worker.new
other = Other.new
worker.ready?
other.ready?
[1].each { |ready| puts ready }
# ready? stays here.
label = "ready?"
