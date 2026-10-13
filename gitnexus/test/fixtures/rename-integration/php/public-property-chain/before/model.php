<?php
class Leaf {
    public int $score = 0;
    public int $Score = 9;
}
class Branch {
    public Leaf $leaf;
}
class Root {
    public Branch $branch;
}
function update(Root $root) {
    $score = 1;
    $root->branch->leaf->score = $root->branch->leaf->score + $score;
    return $root->branch->leaf->score + $root->branch->leaf->Score;
}
// score stays here.
$label = "score";
