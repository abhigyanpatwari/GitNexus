class Repo
  def initialize(path)
    @path = path
  end

  def save
    true
  end
end

# @return [Repo]
def get_repo(path)
  Repo.new(path)
end
