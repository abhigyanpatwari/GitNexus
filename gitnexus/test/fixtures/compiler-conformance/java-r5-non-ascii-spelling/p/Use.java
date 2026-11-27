package p;
// ü 𝒳 漢字 shift every later byte offset away from its string offset
class Use {
  void annotated(Äußer.@Ann("ü") Ünïcödé value) { value.save(); }
  void blockComment(Äußer./* ü */ Ünïcödé value) { value.save(); }
  void lineComment(Äußer. // ü
      Ünïcödé value) { value.save(); }
  void commentThenAnnotation(Äußer./* 𝒳 */ @Ann("漢字") Ünïcödé value) { value.save(); }
  void supplementary(Äußer.@Ann 𝒳漢字 value) { value.save(); }
  Äußer.@Ann /* 𝒳 */ Ünïcödé field;
  void viaField() { field.save(); }
  void local() { Äußer./* 𝒳 */ @Ann 𝒳漢字 v = null; v.save(); }
}
