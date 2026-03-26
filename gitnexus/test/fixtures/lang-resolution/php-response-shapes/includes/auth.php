<?php
function is_logged_in() {
    return isset($_SESSION['user']);
}
