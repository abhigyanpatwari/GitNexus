class Leaf
  def points=(value)
    @score = value
  end
end
class Branch
  def leaf
    Leaf.new
  end
end
class Root
  def branch
    Branch.new
  end
end
class Other
  def score=(value)
    @score = value
  end
end
root = Root.new
other = Other.new
root.branch.leaf.points = 1
other.score = 2
score = "score"
# score stays here.
