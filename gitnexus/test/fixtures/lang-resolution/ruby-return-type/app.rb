require_relative 'models'
require_relative 'repo'

def process_user
  user = get_user('alice')
  user.save
end

def process_repo
  repo = get_repo('/data')
  repo.save
end
