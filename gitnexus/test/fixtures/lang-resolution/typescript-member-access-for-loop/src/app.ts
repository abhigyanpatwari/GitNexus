import { User } from './models/User';
import { Repo } from './models/Repo';

class UserService {
    constructor(private users: User[]) {}

    processUsers(users: Repo[]) {
        for (const user of this.users) {
            user.save();
        }
    }
}

class RepoService {
    constructor(private repos: Repo[]) {}

    processRepos(repos: User[]) {
        for (const repo of this.repos) {
            repo.save();
        }
    }
}

// A same-named parameter does not establish a field on this receiver.
class MissingFieldService {
    processMissingUsers(users: User[]) {
        for (const user of this.users) {
            user.save();
        }
    }
}
