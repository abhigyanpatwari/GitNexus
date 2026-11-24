package client;

import api.Root;

class Missing {}
class Hidden {}
class Clash {}

class Valid extends Root.Open {}
class Inherited extends Root.Nested {}
class FullyQualified extends api.Root.Nested {}
class MissingBase extends Root.Missing {}
class PrivateBase extends Root.Hidden {}
class AmbiguousBase extends Root.Clash {}
