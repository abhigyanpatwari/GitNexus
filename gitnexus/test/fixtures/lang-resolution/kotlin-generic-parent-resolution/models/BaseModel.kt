package models

open class BaseModel<T> {
    open fun save(): Boolean = true
}
