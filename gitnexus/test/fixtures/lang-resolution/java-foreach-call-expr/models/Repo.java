package models;

import java.util.List;

public class Repo {
    private String name;

    public Repo(String name) {
        this.name = name;
    }

    public void save() {}

    public static List<Repo> getRepos() {
        return List.of(new Repo("main"));
    }
}
