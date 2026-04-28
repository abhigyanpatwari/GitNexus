let repo = SqlRepository()
repo.find(id: 42)
repo.find(name: "alice", exact: true)
repo.save(data: "test")
