package app;
import java.util.*;
import models.User;
class OnDemandVar { void run(String List, List<User> users) { for (var u : users) u.save(); } }
