<?php
use function Source\{CALCULATE as localCalculate, other};
function middle() { return localCalculate() + other(); }
