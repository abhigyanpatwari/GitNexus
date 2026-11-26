/** Fixed confidence scores for graph edges and resolution fallbacks. */
export const EdgeConfidence = {
  /** A parsed file directly defines a symbol. */
  fileDefinition: 1,
  /** A method or property belongs to its enclosing owner. */
  memberOwnership: 1,
  /** A file or directory belongs to its parent directory. */
  directoryContainment: 1,
  /** A Markdown heading belongs to its parent section or file. */
  markdownHeading: 1,
  /** A Markdown link points to an indexed file. */
  markdownLink: 0.8,
  /** An import resolves to a file in the graph. */
  resolvedImport: 1,

  /** Default for a reference emitted with a resolved target. */
  resolvedReference: 0.85,
  /** A free call resolves to a local or imported definition. */
  resolvedFreeCall: 0.85,
  /** A free call falls back to a global name match. */
  globalNameFallback: 0.5,
  /** A call resolves through a callable registered on a property. */
  propertyDispatch: 0.7,
  /** A property access falls back to a unique matching property name. */
  uniquePropertyName: 0.5,
  /** A member resolves from the known shape of a returned value. */
  returnShapeMember: 0.9,
  /** A value reference resolves to a definition through a finalized import. */
  importedValueReference: 0.9,
  /** A framework route resolves to a controller method by global class name. */
  routeControllerCall: 0.5,
  /** A fetch endpoint resolves to a known route. */
  fetchRoute: 0.9,

  /** A heritage reference resolves to a base type. */
  resolvedInheritance: 0.85,
  /** A type satisfies an interface through its method set. */
  interfaceImplementation: 0.85,
  /** An override has one defining ancestor. */
  singleAncestorOverride: 0.9,
  /** The method resolution order identifies the first matching definition. */
  mroOrderedMethod: 0.9,
  /** Method selection falls back to the first definition. */
  mroFirstDefinition: 0.7,
  /** A class method takes precedence over interface defaults. */
  mroClassMethod: 0.95,
  /** Multiple interfaces define the method and leave the dispatch ambiguous. */
  mroAmbiguousInterface: 0.5,
  /** Exactly one interface supplies the default method. */
  mroSingleInterfaceDefault: 0.85,
  /** Method resolution finds no matching definition. */
  mroUnresolved: 0.5,
  /** Method dispatch requires a qualified call. */
  mroRequiresQualification: 0.5,
} as const;
