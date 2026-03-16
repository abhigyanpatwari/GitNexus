package models

type BaseModel struct{}

func (b *BaseModel) Save() bool {
    return true
}
