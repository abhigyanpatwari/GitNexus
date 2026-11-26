class GlobalThing { hit() {} }
if (true) { var watched = () => 1; }
function local() { var watched = () => 2; return watched(); }
class Nearby { static { var watched = () => 3; watched(); } }
