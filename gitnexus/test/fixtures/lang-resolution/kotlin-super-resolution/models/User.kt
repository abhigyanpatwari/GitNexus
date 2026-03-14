package models

class User : BaseModel() {
    override fun save(): Boolean {
        super.save()
        return true
    }
}
