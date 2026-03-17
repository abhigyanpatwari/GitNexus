package models

class User(val name: String) extends BaseModel with Serializable {
  override def serialize(): String = name
}
