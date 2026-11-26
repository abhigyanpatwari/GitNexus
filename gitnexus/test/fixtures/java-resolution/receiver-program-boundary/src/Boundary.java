public class Boundary {
    public void platform(String raw) {
        // Rooted at `System`, which the language itself names. Nothing was
        // lost: no node in this index could have been the target.
        System.out.println(raw);
    }

    public void unknownReceiver(OrderRepository repo) {
        // `OrderRepository` is declared nowhere here and is not a platform
        // name. Absence of evidence is not evidence of externality — this must
        // stay hedged, or a genuinely missing in-program caller gets published
        // as `exact`. Spelled as a CHAIN on purpose: a bare `repo.findAll()`
        // never reaches the drop recorder at all (the pass takes a different
        // arm and records nothing), so it would assert on an empty set.
        repo.find().save();
    }
}
