/**
 * One argument of a Spring annotation or of a messaging-template call, captured
 * exactly as it is written in source.
 *
 * Capture-time facts are deliberately UNRESOLVED. When these facts are produced
 * the file's imports are not finalized, constants declared in sibling files do
 * not exist yet, and no configuration source has been read — so a captured
 * `text` may be a string literal, a constant reference (`Destinations.ORDERS`),
 * a property placeholder (`"${app.orders.topic}"`), or an arbitrary expression.
 * Turning any of those into an address is a separate, later phase; nothing here
 * may call a resolver.
 */
export interface SpringArgumentFact {
  /**
   * Argument name for a named argument, absent for a positional one.
   *
   * The two forms carry the same information in different places: an annotation
   * names its destination (`@KafkaListener(topics = ...)` versus
   * `@RabbitListener(queues = ...)`), while a template call gives it by
   * position (`kafkaTemplate.send(topic, payload)`).
   */
  readonly name?: string;
  /** Argument value exactly as written, with quotes, braces, and casts intact. */
  readonly text: string;
}
