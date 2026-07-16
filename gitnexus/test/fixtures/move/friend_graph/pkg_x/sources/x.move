module pkg_x::m_x {
    friend pkg_y::m_y;

    public(friend) fun secret(): u64 {
        7
    }

    public fun call_into_y(): u64 {
        pkg_y::m_y::peek()
    }
}
