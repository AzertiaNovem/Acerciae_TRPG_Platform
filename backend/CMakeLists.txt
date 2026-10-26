cmake_minimum_required(VERSION 3.20)
project(acerciae_backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
add_compile_options(-Wall -Wextra -Wno-unused-parameter)

find_package(Drogon CONFIG REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(PQXX REQUIRED IMPORTED_TARGET libpqxx)
pkg_check_modules(JSONCPP REQUIRED IMPORTED_TARGET jsoncpp)
pkg_check_modules(POPPLER REQUIRED IMPORTED_TARGET poppler-cpp)
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)

file(GLOB_RECURSE LIB_SOURCES CONFIGURE_DEPENDS src/*.cpp)
list(REMOVE_ITEM LIB_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/src/main.cpp)

add_library(acerciae_core STATIC ${LIB_SOURCES})
target_include_directories(acerciae_core PUBLIC src)
target_link_libraries(acerciae_core PUBLIC Drogon::Drogon PkgConfig::PQXX PkgConfig::JSONCPP PkgConfig::POPPLER CURL::libcurl OpenSSL::SSL OpenSSL::Crypto Threads::Threads)

add_executable(acerciae-server src/main.cpp)
target_link_libraries(acerciae-server PRIVATE acerciae_core)

# ---- tests ----
enable_testing()
add_executable(unit_tests tests/unit/unit_tests.cpp)
target_link_libraries(unit_tests PRIVATE acerciae_core)
add_test(NAME unit_tests COMMAND unit_tests)

add_executable(db_tests tests/integration/db_tests.cpp)
target_link_libraries(db_tests PRIVATE acerciae_core)
add_test(NAME db_tests COMMAND db_tests WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

install(TARGETS acerciae-server RUNTIME DESTINATION bin)
install(DIRECTORY migrations DESTINATION share/acerciae)
