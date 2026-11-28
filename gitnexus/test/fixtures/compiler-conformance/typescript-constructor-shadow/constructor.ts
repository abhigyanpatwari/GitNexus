class TsRepo { save() {} }
class TsActual { save() {} }
function tsShadow(TsRepo: any) {
  class TsHolder { static item = new TsRepo(); }
  TsHolder.item.save();
}
function tsAnnotated(TsRepo: any) {
  class AnnotatedHolder { static item: TsRepo; }
  AnnotatedHolder.item.save();
}
tsShadow(TsActual);
tsAnnotated(TsActual);
