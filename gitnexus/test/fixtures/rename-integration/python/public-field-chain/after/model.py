class Leaf:
    points: int = 0
class Branch:
    leaf: Leaf
class Root:
    branch: Branch
class Other:
    score: int = 9
def update(root: Root, other: Other):
    root.branch.leaf.points = root.branch.leaf.points + 1
    return root.branch.leaf.points + other.score
def shadow(score):
    return score
# score stays here.
label = "score"
