require_relative './models'

class DataService
  # @param repo [UserRepo] the user repository
  # @param cache [Hash<Symbol, UserRepo>] cache of repos by symbol key
  def sync(repo, cache)
    repo.save
    repo.find_all
  end

  # @param [AdminRepo] admin_repo the admin repository (alternate YARD order)
  def audit(admin_repo)
    admin_repo.save
    admin_repo.find_all
  end
end
