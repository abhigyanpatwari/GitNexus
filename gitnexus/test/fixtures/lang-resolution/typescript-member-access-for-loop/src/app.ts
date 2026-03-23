import { User } from './models/User';
import { Repo } from './models/Repo';

class UserService {
    processUsers(users: User[]) {
        for (const user of this.users) {
            user.save();
        }
    }
}

class RepoService {
    processRepos(repos: Repo[]) {
        for (const repo of this.repos) {
            repo.save();
        }
    }
}
