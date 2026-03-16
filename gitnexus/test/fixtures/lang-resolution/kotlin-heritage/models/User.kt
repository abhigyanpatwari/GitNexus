package models

import interfaces.Serializable
import interfaces.Validatable

data class User(val name: String) : BaseModel(), Serializable, Validatable {
    override fun serialize(): String = name

    override fun validate(): Boolean = name.isNotEmpty()
}
