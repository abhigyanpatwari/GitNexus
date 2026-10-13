class Leaf:
    score: int = 0
class Branch:
    leaf: Leaf
class Root:
    branch: Branch
class Other:
    score: int = 9
def update(root: Root, other: Other):
    root.branch.leaf.score = root.branch.leaf.score + 1
    return root.branch.leaf.score + other.score
def shadow(score):
    return score
# score stays here.
label = "score"
