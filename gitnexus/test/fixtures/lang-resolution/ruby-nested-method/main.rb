def boot
  def target
    :nested
  end
end

def caller
  boot
  target
end
