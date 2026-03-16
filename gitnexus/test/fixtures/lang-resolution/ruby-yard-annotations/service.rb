require_relative './models'

class UserService
  # @param repo [UserRepo] the repository
  # @param user [User] the user to create
  # @return [Boolean]
  def create(repo, user)
    repo.save
    user.greet
  end
end
