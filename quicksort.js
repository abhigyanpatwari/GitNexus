/**
 * Quicksort implementation in JavaScript
 * Time Complexity: O(n log n) average, O(n²) worst case
 * Space Complexity: O(log n) average, O(n) worst case
 */

function quicksort(arr) {
  // Base case: arrays with 0 or 1 element are already sorted
  if (arr.length <= 1) {
    return arr;
  }

  // Choose pivot (middle element to avoid worst case on sorted arrays)
  const pivotIndex = Math.floor(arr.length / 2);
  const pivot = arr[pivotIndex];

  // Partition array into elements less than, equal to, and greater than pivot
  const left = [];
  const equal = [];
  const right = [];

  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < pivot) {
      left.push(arr[i]);
    } else if (arr[i] === pivot) {
      equal.push(arr[i]);
    } else {
      right.push(arr[i]);
    }
  }

  // Recursively sort left and right partitions, then combine
  return [...quicksort(left), ...equal, ...quicksort(right)];
}

// In-place quicksort implementation (more memory efficient)
function quicksortInPlace(arr, left = 0, right = arr.length - 1) {
  if (left < right) {
    const pivotIndex = partition(arr, left, right);
    quicksortInPlace(arr, left, pivotIndex - 1);
    quicksortInPlace(arr, pivotIndex + 1, right);
  }
  return arr;
}

function partition(arr, left, right) {
  const pivot = arr[right];
  let i = left - 1;

  for (let j = left; j < right; j++) {
    if (arr[j] <= pivot) {
      i++;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  [arr[i + 1], arr[right]] = [arr[right], arr[i + 1]];
  return i + 1;
}

// Example usage and testing
const testArray = [64, 34, 25, 12, 22, 11, 90];
console.log('Original array:', testArray);
console.log('Sorted array (functional):', quicksort([...testArray]));
console.log('Sorted array (in-place):', quicksortInPlace([...testArray]));

// Export for use in other modules
module.exports = { quicksort, quicksortInPlace };
