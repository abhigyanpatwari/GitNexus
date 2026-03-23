from models.user import User
from models.repo import Repo
from typing import List

class UserService:
    def process_users(self, users: List[User]):
        for user in self.users:
            user.save()

class RepoService:
    def process_repos(self, repos: List[Repo]):
        for repo in self.repos:
            repo.save()
