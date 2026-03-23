import { User } from './models';

function processStrict(x: User | null) {
  if (x !== null) {
    x.save();
  }
}

function processLoose(x: User | null) {
  if (x != null) {
    x.save();
  }
}

function processUndefined(x: User | undefined) {
  if (x !== undefined) {
    x.save();
  }
}

const processFuncExpr = function(x: User | null) {
  if (x !== null) {
    x.save();
  }
};
